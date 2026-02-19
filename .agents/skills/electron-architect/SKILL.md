---
name: electron-architect
description: Electron desktop application architect. Use when designing Electron apps, implementing IPC communication, handling security best practices, or packaging for distribution.
---

# Electron Architecture Expert

Expert assistant for Electron desktop application architecture, Main/Renderer process design, IPC communication, security best practices, and application packaging.

## Thinking Process

When activated, follow this structured thinking approach to design Electron applications:

### Step 1: Application Requirements Analysis

**Goal:** Understand what the desktop application needs to accomplish.

**Key Questions to Ask:**
- What is the core functionality? (editor, dashboard, utility, media)
- What system resources are needed? (file system, network, hardware)
- What is the target platform? (macOS, Windows, Linux, or all)
- Are there offline requirements?
- What is the expected data sensitivity? (local files, credentials, user data)

**Actions:**
1. List all features requiring system access (files, network, native APIs)
2. Identify user interaction patterns (single window, multi-window, tray app)
3. Determine data persistence needs (local storage, SQLite, file system)
4. Map integration points (external APIs, local services, hardware)

**Decision Point:** You should be able to articulate:
- "This app needs access to [X] system resources"
- "The main user flows are [Y]"
- "Security sensitivity level is [Z]"

### Step 2: Architecture Design (Security First)

**Goal:** Design a secure Main/Renderer architecture.

**Thinking Framework - Security Principles:**
1. **Least Privilege:** Renderer should have minimal capabilities
2. **Defense in Depth:** Multiple layers of protection
3. **Explicit Communication:** All IPC channels are explicit and validated

**Architecture Decision Matrix:**

| Capability Needed | Where to Implement | Security Consideration |
|------------------|-------------------|------------------------|
| UI Rendering | Renderer process | Treat as untrusted (like a browser) |
| File system access | Main process | Expose via validated IPC |
| Network requests | Main process preferred | Avoid renderer CORS issues |
| Native dialogs | Main process | User consent for file access |
| Crypto operations | Main process | Protect keys from renderer |
| Shell commands | Main process only | Never expose to renderer |

**Decision Point:** For each feature, answer:
- "Does this need Main process access?"
- "What is the minimal IPC surface needed?"

### Step 3: IPC Design

**Goal:** Design safe, type-safe IPC communication.

**Thinking Framework:**
- "What data flows between Main and Renderer?"
- "Who initiates the communication?"
- "What validation is needed on each end?"

**IPC Pattern Selection:**

| Communication Need | Pattern | Direction |
|-------------------|---------|-----------|
| Request/response | invoke/handle | Renderer → Main |
| Fire and forget | send | Renderer → Main |
| Push notification | webContents.send | Main → Renderer |
| Two-way stream | MessagePort | Bidirectional |

**IPC Security Checklist:**
- [ ] All channels have explicit names
- [ ] Input validation on Main process handlers
- [ ] No arbitrary code execution from renderer input
- [ ] Sensitive operations require user confirmation
- [ ] Rate limiting for expensive operations

**Type Safety Pattern:**
```typescript
// Define channel types in shared/
interface IpcChannels {
  'file:open': { args: void; return: string | null };
  'file:save': { args: { path: string; content: string }; return: boolean };
}
```

### Step 4: Preload Script Design

**Goal:** Create a minimal, secure bridge between worlds.

**Thinking Framework:**
- "What is the absolute minimum the renderer needs?"
- "Am I exposing more than necessary?"
- "Is each exposed function validated?"

**Preload Design Principles:**
1. **Minimal Surface:** Only expose what's absolutely needed
2. **No Raw IPC:** Wrap ipcRenderer, don't expose directly
3. **Type Definitions:** Provide TypeScript types for renderer
4. **One-Way Binding:** Prefer invoke over send/on pairs

**Anti-Patterns to Avoid:**
```typescript
// BAD: Exposes raw ipcRenderer
contextBridge.exposeInMainWorld('electron', { ipcRenderer });

// BAD: Arbitrary channel execution
contextBridge.exposeInMainWorld('api', {
  send: (channel, data) => ipcRenderer.send(channel, data)
});

// GOOD: Explicit, limited API
contextBridge.exposeInMainWorld('api', {
  openFile: () => ipcRenderer.invoke('dialog:openFile'),
  saveFile: (content: string) => ipcRenderer.invoke('file:save', content)
});
```

### Step 5: Window Management Strategy

**Goal:** Design appropriate window management for the application.

**Thinking Framework:**
- "How many windows does this app need?"
- "How do windows communicate?"
- "What happens when windows are closed?"

**Window Patterns:**

| App Type | Pattern |
|----------|---------|
| Single document | One main window |
| Multi-document | Window per document, shared state in Main |
| Dashboard + details | Parent-child windows |
| System utility | Tray app with popup |

**Window Configuration Checklist:**
- [ ] Appropriate webPreferences for each window type
- [ ] Window state persistence (position, size)
- [ ] Proper close/quit behavior (hide vs destroy)
- [ ] Deep linking / protocol handling

### Step 6: Data Persistence Strategy

**Goal:** Design secure, reliable data storage.

**Thinking Framework:**
- "What data needs to persist?"
- "How sensitive is this data?"
- "Does data need to sync across devices?"

**Storage Options:**

| Data Type | Solution | Security |
|-----------|----------|----------|
| User preferences | electron-store | Plain or encrypted |
| Structured data | SQLite (better-sqlite3) | File-level encryption |
| Large files | File system | OS-level permissions |
| Credentials | system keychain (keytar) | OS secure storage |

**Data Security Checklist:**
- [ ] Sensitive data encrypted at rest
- [ ] Credentials in system keychain, not files
- [ ] Backup/export functionality
- [ ] Data migration strategy for updates

### Step 7: Packaging and Distribution

**Goal:** Configure reliable cross-platform distribution.

**Thinking Framework:**
- "Which platforms are targets?"
- "How will updates be delivered?"
- "What signing/notarization is needed?"

**Platform Checklist:**

| Platform | Signing | Distribution |
|----------|---------|--------------|
| macOS | Developer ID + Notarization | DMG, PKG, or Mac App Store |
| Windows | Code signing certificate | NSIS, MSI, or Microsoft Store |
| Linux | Optional GPG | AppImage, deb, rpm, Snap |

**Auto-Update Strategy:**
- [ ] electron-updater configuration
- [ ] Update server (GitHub releases, S3, etc.)
- [ ] Staged rollouts for critical updates
- [ ] Rollback capability

### Step 8: Testing Strategy

**Goal:** Ensure the application is reliable across platforms.

**Testing Layers:**
- **Unit Tests:** Business logic in Main process
- **Integration Tests:** IPC communication
- **E2E Tests:** Spectron/Playwright for UI flows
- **Platform Tests:** CI matrix for all target platforms

**Testing Checklist:**
- [ ] Test IPC handlers in isolation
- [ ] Test preload script type contracts
- [ ] E2E tests for critical user flows
- [ ] Platform-specific behavior tests

## Usage

### Scaffold New Project

```bash
bash /mnt/skills/user/electron-architect/scripts/scaffold-project.sh [project-name] [ui-framework] [package-manager]
```

**Arguments:**
- `project-name` - Name of the project (default: my-electron-app)
- `ui-framework` - UI framework: vanilla, react, svelte, vue (default: vanilla)
- `package-manager` - Package manager: pnpm, npm, yarn (default: pnpm)

**Examples:**
```bash
bash /mnt/skills/user/electron-architect/scripts/scaffold-project.sh my-app
bash /mnt/skills/user/electron-architect/scripts/scaffold-project.sh my-app react
bash /mnt/skills/user/electron-architect/scripts/scaffold-project.sh my-app svelte pnpm
```

**Security defaults:**
- nodeIntegration: false
- contextIsolation: true
- sandbox: true

## Documentation Resources

**Official Documentation:**
- Electron: `https://www.electronjs.org/docs/latest/`
- Electron Forge: `https://www.electronforge.io/`
- electron-builder: `https://www.electron.build/`

## Project Structure

```
src/
├── main/
│   ├── main.ts              # Main process entry
│   ├── ipc/                  # IPC handlers
│   │   └── file-handlers.ts
│   ├── services/             # Backend services
│   │   └── database.ts
│   └── menu.ts               # Application menu
├── preload/
│   └── preload.ts            # Context bridge
├── renderer/                 # UI (React/Svelte/Vue)
│   ├── App.tsx
│   └── components/
└── shared/
    └── types.ts              # Shared type definitions
```

## Security Configuration

### BrowserWindow Settings

```typescript
// main.ts - Secure configuration
const mainWindow = new BrowserWindow({
  width: 1200,
  height: 800,
  webPreferences: {
    nodeIntegration: false,      // Disable Node.js
    contextIsolation: true,      // Enable context isolation
    sandbox: true,               // Sandbox mode
    preload: path.join(__dirname, 'preload.js'),
    webSecurity: true,           // Enforce same-origin
  }
});
```

### Preload Script Pattern

```typescript
// preload.ts - Safe API exposure
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  // One-way: Renderer → Main
  saveFile: (content: string) =>
    ipcRenderer.invoke('file:save', content),

  // One-way: Main → Renderer
  onUpdateAvailable: (callback: (version: string) => void) =>
    ipcRenderer.on('update-available', (_, version) => callback(version)),

  // Request-response pattern
  openFile: () => ipcRenderer.invoke('dialog:openFile'),
});

// Type declaration for renderer
declare global {
  interface Window {
    electronAPI: {
      saveFile: (content: string) => Promise<boolean>;
      onUpdateAvailable: (callback: (version: string) => void) => void;
      openFile: () => Promise<string | null>;
    }
  }
}
```

### Main Process Handlers

```typescript
// main/ipc/file-handlers.ts
import { ipcMain, dialog } from 'electron';
import { readFile, writeFile } from 'fs/promises';

export function registerFileHandlers() {
  ipcMain.handle('dialog:openFile', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Text', extensions: ['txt', 'md'] }]
    });
    if (canceled) return null;
    return readFile(filePaths[0], 'utf-8');
  });

  ipcMain.handle('file:save', async (_, content: string) => {
    const { canceled, filePath } = await dialog.showSaveDialog({});
    if (canceled || !filePath) return false;
    await writeFile(filePath, content);
    return true;
  });
}
```

## IPC Communication Patterns

### Pattern 1: Invoke (Request-Response)
```typescript
// Renderer
const data = await window.electronAPI.fetchData(id);

// Main
ipcMain.handle('fetch-data', async (event, id) => {
  return await database.get(id);
});
```

### Pattern 2: Send/On (Fire-and-Forget)
```typescript
// Main → Renderer
mainWindow.webContents.send('notification', message);

// Renderer
window.electronAPI.onNotification((msg) => showToast(msg));
```

### Pattern 3: Two-Way Events
```typescript
// Renderer sends, awaits Main response
const result = await window.electronAPI.processFile(path);
```

## Packaging Configuration

### Electron Forge

```json
{
  "config": {
    "forge": {
      "packagerConfig": {
        "asar": true,
        "icon": "./assets/icon"
      },
      "makers": [
        { "name": "@electron-forge/maker-squirrel" },
        { "name": "@electron-forge/maker-dmg" },
        { "name": "@electron-forge/maker-deb" }
      ]
    }
  }
}
```

## Present Results to User

When providing Electron solutions:
- Always follow security best practices
- Provide complete IPC communication examples
- Consider cross-platform compatibility
- Include TypeScript types for the API
- Note Electron version differences

## Troubleshooting

**"require is not defined"**
- nodeIntegration is correctly disabled
- Use preload script with contextBridge

**"Cannot access window.electronAPI"**
- Check preload script path is correct
- Verify contextIsolation is true
- Ensure contextBridge.exposeInMainWorld is called

**"IPC message not received"**
- Verify channel names match exactly
- Check if handler is registered before window loads
- Use invoke for async responses
