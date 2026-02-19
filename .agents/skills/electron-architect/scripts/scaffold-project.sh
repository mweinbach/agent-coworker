#!/bin/bash
set -e

# Electron Project Scaffold Script
# Creates a secure Electron project structure with best practices

PROJECT_NAME="${1:-my-electron-app}"
UI_FRAMEWORK="${2:-vanilla}"
PACKAGE_MANAGER="${3:-pnpm}"

echo "Creating Electron project: $PROJECT_NAME" >&2
echo "UI Framework: $UI_FRAMEWORK" >&2

cleanup() {
    echo "Scaffold completed" >&2
}
trap cleanup EXIT

show_usage() {
    cat << 'EOF'
Usage: scaffold-project.sh [project-name] [ui-framework] [package-manager]

Arguments:
  project-name     Name of the project (default: my-electron-app)
  ui-framework     UI framework: vanilla, react, svelte, vue (default: vanilla)
  package-manager  Package manager: npm, pnpm, yarn (default: npm)

Examples:
  scaffold-project.sh my-app
  scaffold-project.sh my-app react
  scaffold-project.sh my-app svelte pnpm

Generated Structure:
  project/
  ├── src/
  │   ├── main/           # Main process
  │   │   ├── main.ts
  │   │   └── ipc/
  │   ├── preload/        # Preload scripts
  │   │   └── preload.ts
  │   ├── renderer/       # UI code
  │   └── shared/         # Shared types
  ├── package.json
  └── tsconfig.json

Security:
  - Context isolation enabled
  - Node integration disabled
  - Sandbox mode enabled
EOF
}

# Create project directory
mkdir -p "$PROJECT_NAME"
cd "$PROJECT_NAME"

# Create directory structure
echo "Creating directory structure..." >&2
mkdir -p src/main/ipc
mkdir -p src/preload
mkdir -p src/renderer
mkdir -p src/shared

# Create package.json
echo "Creating package.json..." >&2
cat > package.json << EOF
{
  "name": "$PROJECT_NAME",
  "version": "1.0.0",
  "description": "Electron application with secure defaults",
  "main": "dist/main/main.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "preview": "electron-vite preview",
    "package": "electron-builder",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "electron": "^28.0.0",
    "electron-builder": "^24.0.0",
    "electron-vite": "^2.0.0",
    "typescript": "^5.3.0",
    "vite": "^5.0.0"
  }
}
EOF

# Create tsconfig.json
echo "Creating tsconfig.json..." >&2
cat > tsconfig.json << 'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "baseUrl": ".",
    "paths": {
      "@main/*": ["src/main/*"],
      "@preload/*": ["src/preload/*"],
      "@renderer/*": ["src/renderer/*"],
      "@shared/*": ["src/shared/*"]
    }
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
EOF

# Create main process
echo "Creating main process..." >&2
cat > src/main/main.ts << 'EOF'
import { app, BrowserWindow } from 'electron';
import path from 'path';
import { registerIpcHandlers } from './ipc/handlers';

function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      // Security: Disable Node.js integration
      nodeIntegration: false,
      // Security: Enable context isolation
      contextIsolation: true,
      // Security: Enable sandbox
      sandbox: true,
      // Preload script for safe API exposure
      preload: path.join(__dirname, '../preload/preload.js'),
    },
  });

  // Load the app
  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  return mainWindow;
}

app.whenReady().then(() => {
  registerIpcHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
EOF

# Create IPC handlers
cat > src/main/ipc/handlers.ts << 'EOF'
import { ipcMain, dialog } from 'electron';
import { readFile, writeFile } from 'fs/promises';

export function registerIpcHandlers(): void {
  // File open dialog
  ipcMain.handle('dialog:openFile', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        { name: 'All Files', extensions: ['*'] },
      ],
    });

    if (canceled || filePaths.length === 0) {
      return null;
    }

    const content = await readFile(filePaths[0], 'utf-8');
    return { path: filePaths[0], content };
  });

  // File save dialog
  ipcMain.handle('dialog:saveFile', async (_, content: string) => {
    const { canceled, filePath } = await dialog.showSaveDialog({});

    if (canceled || !filePath) {
      return false;
    }

    await writeFile(filePath, content, 'utf-8');
    return true;
  });

  // App info
  ipcMain.handle('app:getInfo', () => {
    return {
      name: 'Electron App',
      version: '1.0.0',
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome,
    };
  });
}
EOF

# Create preload script
echo "Creating preload script..." >&2
cat > src/preload/preload.ts << 'EOF'
import { contextBridge, ipcRenderer } from 'electron';

// Type definitions for the exposed API
export interface ElectronAPI {
  openFile: () => Promise<{ path: string; content: string } | null>;
  saveFile: (content: string) => Promise<boolean>;
  getAppInfo: () => Promise<{
    name: string;
    version: string;
    electron: string;
    node: string;
    chrome: string;
  }>;
}

// Safely expose APIs to renderer
contextBridge.exposeInMainWorld('electronAPI', {
  openFile: () => ipcRenderer.invoke('dialog:openFile'),
  saveFile: (content: string) => ipcRenderer.invoke('dialog:saveFile', content),
  getAppInfo: () => ipcRenderer.invoke('app:getInfo'),
} satisfies ElectronAPI);
EOF

# Create shared types
cat > src/shared/types.ts << 'EOF'
// Shared type definitions between main and renderer

export interface FileData {
  path: string;
  content: string;
}

export interface AppInfo {
  name: string;
  version: string;
  electron: string;
  node: string;
  chrome: string;
}

// Extend Window interface for renderer
declare global {
  interface Window {
    electronAPI: {
      openFile: () => Promise<FileData | null>;
      saveFile: (content: string) => Promise<boolean>;
      getAppInfo: () => Promise<AppInfo>;
    };
  }
}
EOF

# Create renderer
echo "Creating renderer..." >&2
cat > src/renderer/index.html << 'EOF'
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'">
  <title>Electron App</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      margin: 0;
      padding: 20px;
      background: #1a1a1a;
      color: #ffffff;
    }
    .container { max-width: 800px; margin: 0 auto; }
    button {
      background: #4a9eff;
      color: white;
      border: none;
      padding: 10px 20px;
      border-radius: 6px;
      cursor: pointer;
      margin-right: 10px;
    }
    button:hover { background: #3a8eef; }
    #info { margin-top: 20px; padding: 15px; background: #2a2a2a; border-radius: 8px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Electron App</h1>
    <button id="openBtn">Open File</button>
    <button id="infoBtn">App Info</button>
    <div id="info"></div>
  </div>
  <script src="./renderer.js"></script>
</body>
</html>
EOF

cat > src/renderer/renderer.ts << 'EOF'
// Renderer process code
document.getElementById('openBtn')?.addEventListener('click', async () => {
  const result = await window.electronAPI.openFile();
  const infoDiv = document.getElementById('info');
  if (infoDiv) {
    if (result) {
      infoDiv.innerHTML = `<strong>File:</strong> ${result.path}<br><pre>${result.content.slice(0, 500)}</pre>`;
    } else {
      infoDiv.innerHTML = 'No file selected';
    }
  }
});

document.getElementById('infoBtn')?.addEventListener('click', async () => {
  const info = await window.electronAPI.getAppInfo();
  const infoDiv = document.getElementById('info');
  if (infoDiv) {
    infoDiv.innerHTML = `
      <strong>App:</strong> ${info.name} v${info.version}<br>
      <strong>Electron:</strong> ${info.electron}<br>
      <strong>Node:</strong> ${info.node}<br>
      <strong>Chrome:</strong> ${info.chrome}
    `;
  }
});
EOF

# Create electron-vite config
cat > electron.vite.config.ts << 'EOF'
import { defineConfig } from 'electron-vite';

export default defineConfig({
  main: {
    build: {
      outDir: 'dist/main',
    },
  },
  preload: {
    build: {
      outDir: 'dist/preload',
    },
  },
  renderer: {
    build: {
      outDir: 'dist/renderer',
    },
  },
});
EOF

# Create .gitignore
cat > .gitignore << 'EOF'
node_modules/
dist/
out/
*.log
.DS_Store
EOF

echo "Project created successfully!" >&2

# Output result
cat << EOF
{
  "success": true,
  "project": "$PROJECT_NAME",
  "structure": {
    "main": "src/main/main.ts",
    "preload": "src/preload/preload.ts",
    "renderer": "src/renderer/",
    "shared": "src/shared/types.ts"
  },
  "security": {
    "nodeIntegration": false,
    "contextIsolation": true,
    "sandbox": true
  },
  "next_steps": [
    "cd $PROJECT_NAME",
    "$PACKAGE_MANAGER install",
    "$PACKAGE_MANAGER run dev"
  ]
}
EOF
