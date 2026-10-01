# Shuben Launcher
Minecraft launcher for Windows and macOS: Microsoft login, mod store (Modrinth), skins & capes,
servers from .mrpack modpacks, game-version update checker.

Dev:            npm install && npm start
Windows exe:    npm run dist            (on Windows)  |  npm run dist:win-on-linux  (on Linux, no exe icon)
macOS dmg:      npm run dist:mac        (must run on a Mac)
Both, in CI:    push to GitHub and run the "Build" workflow (.github/workflows/build.yml)

Getting the .dmg (it can only be built on macOS):
  1. On a Mac: unzip this project and double-click build-mac.command. The .dmg appears in the dist folder.
  2. No Mac: upload the project to a GitHub repo, open Actions > Build > Run workflow, then download
     the "shuben-macos-latest" artifact (Intel and Apple Silicon dmgs).
  First launch on a Mac: right-click the app > Open (the build is unsigned).
