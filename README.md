# NIM Studio

A Windows desktop chat and coding assistant for NVIDIA NIM. Each user brings their own API key.

## Install (3 steps)

1. Unzip this folder.
2. Double-click **1-SETUP-AND-INSTALL.bat**. It installs Node.js if needed, builds the app and opens the installer.
3. Open NIM Studio and paste your key from https://build.nvidia.com (starts with `nvapi-`).

To try it without installing, double-click **RUN-WITHOUT-INSTALLING.bat**.

## Automatic updates (set up once)

Installed copies of the app check for updates on launch and every few hours, download them in the
background, and show a **Restart to update** button. Updates are served from a free GitHub repository.

One time:
1. Make a free GitHub account and create an empty **public** repository named `nim-studio`.
2. Double-click **2-CONNECT-GITHUB-ONCE.bat** and enter your username.
3. Run **1-SETUP-AND-INSTALL.bat** and install the app.

Every time you change the app:
- Double-click **3-PUBLISH-UPDATE.bat** and type a higher version number (1.1.1, 1.2.0, ...).
  GitHub builds the installer in about 5 minutes. Everyone's app updates itself.

Notes:
- The portable `.exe` does not auto-update. Use the installer for people who should get updates.
- Copies installed before version 1.1.0 have no updater. Install this version once by hand.
- If you share the app widely, send people the installer from your repository's Releases page.

## Features

- Searchable model picker with favorites (click the star), recent models and sections. Ctrl+K opens it.
- **Mode** menu: Coding assistant, Code reviewer, Debugger, Explain simply, Writing helper, or Custom.
- Syntax-highlighted code with Copy and Save as file, plus tables in replies.
- Per message: Copy, Edit (and resend), Regenerate, and response time.
- Attach files with the button or by dragging them into the window.
- Search chats, rename them (double-click), and export a chat as a Markdown file.
- Light, dark or match-Windows theme in Settings.
- Shortcuts: Ctrl+N new chat, Ctrl+K model picker, Ctrl+L focus the message box, Esc stops a reply.

## Using it

- Click the model name in the top bar. Search, or scroll through Recent, Coding, Reasoning and one section per publisher.
  Use the arrow keys and Enter, or type any model id to use it as-is.
- **Attach** adds source files to your message. Code in replies has **Copy** and **Save as file** buttons.
- **Logs** (bottom of the sidebar) shows every request and error. If a message gets no answer, open Logs and click **Run connection test**.
  It checks your key, the connection to NVIDIA, and a real test message, and says which step fails.
- Settings holds the system prompt, temperature, max tokens and update check. Ctrl+N starts a new chat.

## Where things are stored

- API key: encrypted with Windows DPAPI in `%APPDATA%\NIM Studio\key.bin`, used only by the app's main process.
- Chats and settings: `%APPDATA%\NIM Studio\chats.json`.
- Requests go only to `https://integrate.api.nvidia.com/v1` (and GitHub for update checks).

Windows may show a SmartScreen warning for unsigned installers. Click More info, then Run anyway.
