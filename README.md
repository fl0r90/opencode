<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode logo">
    </picture>
  </a>
</p>
<p align="center">The open source AI coding agent.</p>
<p align="center">
  <a href="https://opencode.ai/discord"><img alt="Discord" src="https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord" /></a>
  <a href="https://www.npmjs.com/package/@opencode/cli"><img alt="npm" src="https://img.shields.io/npm/v/@opencode/cli?style=flat-square" /></a>
  <a href="https://github.com/anomalyco/opencode/actions/workflows/publish.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/anomalyco/opencode/publish.yml?style=flat-square&branch=dev" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a> |
  <a href="README.zht.md">繁體中文</a> |
  <a href="README.ko.md">한국어</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Español</a> |
  <a href="README.fr.md">Français</a> |
  <a href="README.it.md">Italiano</a> |
  <a href="README.da.md">Dansk</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.pl.md">Polski</a> |
  <a href="README.ru.md">Русский</a> |
  <a href="README.bs.md">Bosanski</a> |
  <a href="README.ar.md">العربية</a> |
  <a href="README.no.md">Norsk</a> |
  <a href="README.br.md">Português (Brasil)</a> |
  <a href="README.th.md">ไทย</a> |
  <a href="README.tr.md">Türkçe</a> |
  <a href="README.uk.md">Українська</a> |
  <a href="README.bn.md">বাংলা</a> |
  <a href="README.gr.md">Ελληνικά</a> |
  <a href="README.vi.md">Tiếng Việt</a>
</p>

[![OpenCode Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://opencode.ai)

---

### 🚀 OpenCode Desktop GUI — LM Studio Multi-Server & Master ⇄ Agent Edition (`fl0r90/opencode`)

Această versiune a **OpenCode Desktop** (`packages/desktop` & `packages/app` + `packages/core`) vine pre-configurată cu suport nativ pentru **Cluster LM Studio Multi-Server** și **Orchestrare Multi-Node Master ⇄ Agent (Worker)**:

- **Adăugare directă de servere din GUI (`Settings → Providers`)**: Adaugă oricâte servere LM Studio după `IP:Port` (ex: `192.168.0.25:1234`, `192.168.0.200:1234`, `127.0.0.1:1234`) sau apasă **Scan LAN** pentru detecție automată în subnet.
- **Auto-detecție automată a resurselor**: Citește în timp real modelele încărcate în VRAM (`LOADED`), contextul alocat efectiv (`context_length` / `max_context_length`), suportul pentru **Tools / Function Calling**, **Vision** și latența în milisecunde.
- **Orchestrare Dual-Server Master ⇄ Worker**: Când ai 2+ servere LM Studio pe rețea, folosește un server ca **👑 Master (Arhitect Principal / Planificare)** și celălalt ca **⚡ Agent / Worker (Executant de Cod în Paralel via Subagent)**.

---

### 📦 Ghid Pas cu Pas de Instalare (Linux / macOS / Windows)

#### Metoda 1: Instalare Automată cu o Singură Comandă (Linux & macOS) — *Recomandat*

Deschide terminalul pe orice mașină și rulează:

```bash
curl -fsSL https://raw.githubusercontent.com/fl0r90/opencode/dev/install-desktop.sh | bash
```

Ce face scriptul automat pentru tine:
1. Verifică dacă există deja binare pre-compilate în [GitHub Releases](https://github.com/fl0r90/opencode/releases) și le instalează în câteva secunde.
2. Dacă nu găsește binar gata compilat, își instalează `bun`, clonează repo-ul, compilează backend-ul CLI și Electron Desktop-ul.
3. Instalează executabilul în `~/.local/bin/opencode-desktop` și creează iconița și lansatorul în meniul tău de aplicații (GNOME / KDE / macOS Applications).

---

#### Metoda 2: Descărcare Directă din GitHub Releases

Mergi pe [**GitHub Releases (`fl0r90/opencode/releases`)**](https://github.com/fl0r90/opencode/releases) și descarcă pachetul pentru sistemul tău:

- **Ubuntu / Debian**: descarcă `opencode-desktop-linux-amd64.deb` și instalează-l cu:
  ```bash
  sudo dpkg -i opencode-desktop-linux-amd64.deb
  ```
- **Linux Generic (orice distribuție)**: descarcă `opencode-desktop-linux-x86_64.AppImage`:
  ```bash
  chmod +x opencode-desktop-linux-x86_64.AppImage
  ./opencode-desktop-linux-x86_64.AppImage
  ```
- **macOS**: descarcă `opencode-desktop-mac-arm64.dmg` (Apple Silicon) sau `.zip`, deschide și trage aplicația în `/Applications`.
- **Windows**: descarcă `opencode-desktop-win-x64.exe` și rulează installerul.

---

#### Metoda 3: Compilare Manuală Pas cu Pas din Codul Sursă

Dacă vrei să îl compilezi manual pe mașina ta:

1. **Instalează dependențele preliminare** (Git și Bun):
   ```bash
   curl -fsSL https://bun.sh/install | bash
   export PATH="$HOME/.bun/bin:$PATH"
   ```

2. **Clonează repo-ul**:
   ```bash
   git clone -b dev https://github.com/fl0r90/opencode.git
   cd opencode
   ```

3. **Instalează pachetele workspace-ului**:
   ```bash
   bun install
   ```

4. **Compilează binarul de CLI cu backend-ul personalizat**:
   ```bash
   cd packages/cli
   # Pe Linux:
   bun run script/build.ts --target=opencode-linux-x64-baseline
   # Pe macOS (Apple Silicon):
   # bun run script/build.ts --target=opencode-darwin-arm64
   cd ../..
   ```

5. **Împachetează aplicația Desktop GUI**:
   ```bash
   cd packages/desktop
   export OPENCODE_CHANNEL=prod
   export OPENCODE_CLI_TARGET=x86_64-unknown-linux-gnu
   export OPENCODE_CLI_DIST="$(pwd)/../cli/dist"
   export CSC_IDENTITY_AUTO_DISCOVERY=false

   bun run prebuild
   bun run build
   bunx electron-builder --config electron-builder.config.ts --linux deb AppImage --publish never
   ```
   Găsești pachetele gata în `packages/desktop/dist/`.

---

### 🛠️ Cum configurezi serverele LM Studio în interfață

1. **Deschide aplicația**: din meniul de aplicații sau rulând `opencode-desktop`.
2. **Mergi la Setări**: click pe rotița din stânga jos (**Settings**) → selectează **Providers**.
3. **Adaugă serverele**:
   - În panoul de sus **„LM Studio Multi-Server & Master ⇄ Agent Orchestrator”**, scrie IP-ul și portul (ex: `192.168.0.25:1234`) și apasă **Add & Discover Server** (sau apasă **Scan LAN**).
   - Serverul va apărea cu bulină verde, latența în `ms` și lista completă de modele încărcate în VRAM.
4. **Setează Master & Agent**:
   - Apasă pe butonul **„Auto-Elect Best Master & Agent”** sau alege manual din meniurile dropdown:
     - **👑 Master**: alege serverul și modelul principal de gândire/arhitectură.
     - **⚡ Agent (Worker)**: alege al doilea server și modelul dedicat de execuție de cod.
5. **Apasă Apply & Sync**: configurația este salvată instantaneu în OpenCode, iar când lucrezi la un proiect, ambele servere vor executa task-urile în paralel!

---

### Installation

```bash
# YOLO
curl -fsSL https://opencode.ai/install | bash

# Package managers
npm i -g @opencode/cli@latest      # or bun/pnpm/yarn
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS and Linux (recommended, always up to date)
brew install opencode              # macOS and Linux (official brew formula, updated less)
sudo pacman -S opencode            # Arch Linux (Stable)
paru -S opencode-bin               # Arch Linux (Latest from AUR)
mise use -g opencode               # Any OS
nix run nixpkgs#opencode           # or github:anomalyco/opencode for latest dev branch
```

> [!TIP]
> Remove versions older than 0.1.x before installing.

### Desktop App (BETA)

OpenCode is also available as a desktop application. Download directly from the [releases page](https://github.com/anomalyco/opencode/releases) or [opencode.ai/download](https://opencode.ai/download).

| Platform              | Download                           |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `opencode-desktop-mac-x64.dmg`     |
| Windows               | `opencode-desktop-windows-x64.exe` |
| Linux                 | `.deb`, `.rpm`, or `.AppImage`     |

```bash
# macOS (Homebrew)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

#### Installation Directory

The install script respects the following priority order for the installation path:

1. `$OPENCODE_INSTALL_DIR` - Custom installation directory
2. `$XDG_BIN_DIR` - XDG Base Directory Specification compliant path
3. `$HOME/bin` - Standard user binary directory (if it exists or can be created)
4. `$HOME/.opencode/bin` - Default fallback

```bash
# Examples
OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://opencode.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://opencode.ai/install | bash
```

### Agents

OpenCode includes two built-in agents you can switch between with the `Tab` key.

- **build** - Default, full-access agent for development work
- **plan** - Read-only agent for analysis and code exploration
  - Denies file edits by default
  - Asks permission before running bash commands
  - Ideal for exploring unfamiliar codebases or planning changes

Also included is a **general** subagent for complex searches and multistep tasks.
This is used internally and can be invoked using `@general` in messages.

Learn more about [agents](https://opencode.ai/docs/agents).

### Documentation

For more info on how to configure OpenCode, [**head over to our docs**](https://opencode.ai/docs).

### Contributing

If you're interested in contributing to OpenCode, please read our [contributing docs](./CONTRIBUTING.md) before submitting a pull request.

### Building on OpenCode

If you are working on a project that's related to OpenCode and is using "opencode" as part of its name, for example "opencode-dashboard" or "opencode-mobile", please add a note to your README to clarify that it is not built by the OpenCode team and is not affiliated with us in any way.

---

**Join our community** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
