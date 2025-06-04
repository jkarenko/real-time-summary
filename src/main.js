// Main process - Electron main process with TranscriptSummarizer integration

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

// Import the existing TranscriptSummarizer class
const { TranscriptSummarizer } = require('../transcript-summarizer');

// Audio recording system classes
class MacOSAudioManager {
    async detectBlackHole() {
        return new Promise((resolve) => {
            exec('system_profiler SPAudioDataType', (error, stdout) => {
                if (error) {
                    resolve({ installed: false, error: error.message });
                    return;
                }
                
                const hasBlackHole = stdout.includes('BlackHole');
                const blackHoleDevices = this.parseBlackHoleDevices(stdout);
                
                resolve({
                    installed: hasBlackHole,
                    devices: blackHoleDevices,
                    needsSetup: hasBlackHole && blackHoleDevices.length === 0
                });
            });
        });
    }

    async getAvailableAudioInputs() {
        return new Promise((resolve) => {
            exec('system_profiler SPAudioDataType', (error, stdout) => {
                if (error) {
                    console.error('Error getting audio inputs:', error);
                    resolve([]);
                    return;
                }
                
                const audioInputs = this.parseAudioInputs(stdout);
                resolve(audioInputs);
            });
        });
    }

    parseBlackHoleDevices(profileOutput) {
        const devices = [];
        const lines = profileOutput.split('\n');
        
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes('BlackHole')) {
                // Extract device information
                const deviceInfo = this.extractDeviceInfo(lines, i);
                if (deviceInfo) {
                    devices.push(deviceInfo);
                }
            }
        }
        
        return devices;
    }

    extractDeviceInfo(lines, startIndex) {
        // Look for device details in the following lines
        for (let i = startIndex; i < Math.min(startIndex + 10, lines.length); i++) {
            const line = lines[i].trim();
            if (line.includes('BlackHole')) {
                return {
                    name: line.replace(/^\w+:\s*/, ''),
                    detected: true
                };
            }
        }
        return null;
    }

    parseAudioInputs(profileOutput) {
        const devices = [];
        const lines = profileOutput.split('\n');
        let currentDevice = null;
        let inInputSection = false;
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            
            // Look for device names (they typically end with a colon)
            if (line.match(/^[A-Z].*:$/) && !line.includes('Data Type')) {
                currentDevice = {
                    name: line.replace(':', ''),
                    id: line.replace(':', '').toLowerCase().replace(/\s+/g, '_'),
                    inputs: [],
                    hasInputs: false
                };
                inInputSection = false;
            }
            
            // Look for input-related information
            if (currentDevice) {
                if (line.includes('Input Source') || line.includes('Built-in Input') || 
                    line.includes('Microphone') || line.includes('Line In') ||
                    line.includes('BlackHole')) {
                    inInputSection = true;
                    currentDevice.hasInputs = true;
                    
                    // Extract input name
                    let inputName = line;
                    if (line.includes(':')) {
                        inputName = line.split(':')[0].trim();
                    }
                    
                    if (inputName && !currentDevice.inputs.includes(inputName)) {
                        currentDevice.inputs.push(inputName);
                    }
                }
                
                // If we hit a new device section, save the previous one
                if (line.match(/^[A-Z].*:$/) && !line.includes('Data Type') && i > 0) {
                    if (currentDevice.hasInputs && !devices.find(d => d.id === currentDevice.id)) {
                        devices.push(currentDevice);
                    }
                }
            }
        }
        
        // Add the last device if it has inputs
        if (currentDevice && currentDevice.hasInputs && !devices.find(d => d.id === currentDevice.id)) {
            devices.push(currentDevice);
        }
        
        // Add common default devices if not found
        const commonDevices = [
            { name: 'Built-in Microphone', id: 'built_in_microphone', inputs: ['Built-in Microphone'], hasInputs: true },
            { name: 'Default System Input', id: 'default', inputs: ['Default'], hasInputs: true }
        ];
        
        commonDevices.forEach(commonDevice => {
            if (!devices.find(d => d.id === commonDevice.id)) {
                devices.unshift(commonDevice); // Add to beginning
            }
        });
        
        return devices;
    }
}

class AudioSetupGuide {
    showMacOSSetup(blackHoleStatus) {
        if (!blackHoleStatus.installed) {
            return this.showBlackHoleInstallation();
        }
        
        if (blackHoleStatus.needsSetup) {
            return this.showMultiOutputSetup();
        }
        
        return this.showReadyState();
    }

    showBlackHoleInstallation() {
        return {
            title: "Install BlackHole Audio Driver",
            steps: [
                "Download BlackHole from https://github.com/ExistentialAudio/BlackHole",
                "Install the .pkg file and restart your Mac",
                "Return to this app to continue setup"
            ],
            canProceed: false,
            helpUrl: "https://github.com/ExistentialAudio/BlackHole/wiki/Installation"
        };
    }

    showMultiOutputSetup() {
        return {
            title: "Configure Multi-Output Device",
            steps: [
                "Open Audio MIDI Setup (in /Applications/Utilities/)",
                "Click the '+' button and select 'Create Multi-Output Device'",
                "Check both 'Built-in Output' and 'BlackHole 2ch'",
                "Right-click the Multi-Output Device and select 'Use This Device For Sound Output'",
                "In your meeting app (Teams/Zoom), select BlackHole as microphone input"
            ],
            canProceed: true,
            verification: "Test audio setup"
        };
    }

    showReadyState() {
        return {
            title: "Audio Setup Complete",
            steps: [
                "BlackHole is installed and ready",
                "You can now record system audio from meeting apps"
            ],
            canProceed: true,
            verification: null
        };
    }
}

class AudioFileManager {
    constructor() {
        this.currentSession = null;
        this.audioChunks = [];
    }

    startSession(sessionContext, userDataPath) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const sessionDir = path.join(userDataPath, 'recordings', timestamp);
        
        fs.mkdirSync(sessionDir, { recursive: true });
        
        this.currentSession = {
            id: timestamp,
            directory: sessionDir,
            audioFile: path.join(sessionDir, 'audio.webm'),
            transcriptFile: path.join(sessionDir, 'transcript.txt'),
            metadataFile: path.join(sessionDir, 'metadata.json'),
            context: sessionContext
        };

        // Initialize files
        fs.writeFileSync(this.currentSession.transcriptFile, '');
        fs.writeFileSync(this.currentSession.metadataFile, JSON.stringify({
            sessionId: this.currentSession.id,
            startTime: new Date().toISOString(),
            context: sessionContext,
            audioFormat: 'webm/opus',
            chunks: []
        }, null, 2));

        return this.currentSession;
    }

    async processAudioChunk(chunkBuffer) {
        if (!this.currentSession) return;

        try {
            // Append to audio file
            fs.appendFileSync(this.currentSession.audioFile, Buffer.from(chunkBuffer));
            
            // Update metadata
            const metadata = JSON.parse(fs.readFileSync(this.currentSession.metadataFile, 'utf8'));
            metadata.chunks.push({
                timestamp: new Date().toISOString(),
                size: chunkBuffer.byteLength
            });
            fs.writeFileSync(this.currentSession.metadataFile, JSON.stringify(metadata, null, 2));

            console.log(`Processed audio chunk: ${chunkBuffer.byteLength} bytes`);
            
            // Trigger transcription (placeholder for Phase 2)
            // this.triggerTranscription(chunkBuffer);
        } catch (error) {
            console.error('Error processing audio chunk:', error);
        }
    }

    stopSession() {
        if (this.currentSession) {
            // Update metadata with end time
            try {
                const metadata = JSON.parse(fs.readFileSync(this.currentSession.metadataFile, 'utf8'));
                metadata.endTime = new Date().toISOString();
                metadata.duration = new Date() - new Date(metadata.startTime);
                fs.writeFileSync(this.currentSession.metadataFile, JSON.stringify(metadata, null, 2));
            } catch (error) {
                console.error('Error updating session metadata:', error);
            }
            
            const sessionData = this.currentSession;
            this.currentSession = null;
            return sessionData;
        }
        return null;
    }
}

class ElectronTranscriptApp {
    constructor() {
        this.mainWindow = null;
        this.summarizer = null;
        this.currentScreenshotFilter = 'session'; // Track current filter state
        this.appSettings = {
            transcriptFile: '',
            screenshotsDir: '',
            windowState: {
                width: 1400,
                height: 900,
                x: undefined,
                y: undefined
            },
            audio: {
                recordingEnabled: false,
                audioSources: ['microphone'],
                audioQuality: 'standard',
                autoTranscribe: true,
                selectedMicrophone: 'default'
            }
        };
        
        // Audio system components
        this.macOSAudioManager = new MacOSAudioManager();
        this.audioSetupGuide = new AudioSetupGuide();
        this.audioFileManager = new AudioFileManager();
        this.blackHoleStatus = null;
        
        // Transcript tracking
        this.wordCount = 0;
        this.currentPosition = 0;
        
        this.setupApp();
    }

    async initializeAudioSystem() {
        console.log('Initializing audio system...');
        
        // Only initialize on macOS for now
        if (process.platform === 'darwin') {
            try {
                this.blackHoleStatus = await this.macOSAudioManager.detectBlackHole();
                console.log('BlackHole detection result:', this.blackHoleStatus);
            } catch (error) {
                console.error('Error detecting BlackHole:', error);
                this.blackHoleStatus = { installed: false, error: error.message };
            }
        } else {
            console.log('Audio recording not yet supported on', process.platform);
        }
    }

    setupApp() {
        console.log('Setting up Electron app...');
        
        // App event handlers
        app.whenReady().then(() => {
            console.log('Electron app ready, creating window...');
            this.createWindow();
        });
        
        app.on('window-all-closed', () => {
            if (process.platform !== 'darwin') {
                app.quit();
            }
        });

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) {
                this.createWindow();
            }
        });

        // Setup IPC handlers
        this.setupIPC();
        
        // Initialize audio system
        this.initializeAudioSystem();
    }

    async createWindow() {
        console.log('createWindow called');
        
        // Create application menu
        this.createMenu();
        
        // Load saved window state
        this.loadWindowState();
        console.log('Loaded settings:', this.appSettings);

        // Create the browser window
        this.mainWindow = new BrowserWindow({
            width: this.appSettings.windowState.width,
            height: this.appSettings.windowState.height,
            // Remove x,y positioning to let Electron center the window
            // x: this.appSettings.windowState.x,
            // y: this.appSettings.windowState.y,
            minWidth: 1000,
            minHeight: 700,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                preload: path.join(__dirname, 'preload.js')
            },
            titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
            show: false // Don't show until ready to prevent flicker
        });

        // Load the HTML file
        console.log('Loading HTML file from:', path.join(__dirname, 'index.html'));
        try {
            await this.mainWindow.loadFile(path.join(__dirname, 'index.html'));
            console.log('HTML file loaded successfully');
        } catch (error) {
            console.error('Failed to load HTML file:', error);
            return;
        }

        // Add timeout fallback to show window even if ready-to-show doesn't fire
        setTimeout(() => {
            if (this.mainWindow && !this.mainWindow.isVisible()) {
                console.log('Window not shown after 3s, forcing show...');
                this.mainWindow.show();
                this.mainWindow.focus();
            }
        }, 3000);

        // Show window when ready
        this.mainWindow.once('ready-to-show', () => {
            console.log('Window ready to show (but waiting for renderer to signal ready)');
            
            // Show file selection dialog if no transcript file is set
            if (!this.appSettings.transcriptFile) {
                console.log('No transcript file set, showing file selection dialog');
                this.mainWindow.show();
                this.mainWindow.focus();
                this.showFileSelectionDialog();
            }
            // If transcript file exists, wait for renderer to be ready before showing
        });

        // Add error handling for renderer process
        this.mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
            console.error('Failed to load renderer:', errorCode, errorDescription);
        });

        this.mainWindow.webContents.on('crashed', () => {
            console.error('Renderer process crashed');
        });

        // Save window state on move/resize
        this.mainWindow.on('moved', () => this.saveWindowState());
        this.mainWindow.on('resized', () => this.saveWindowState());

        // Handle window closed
        this.mainWindow.on('closed', () => {
            this.mainWindow = null;
            if (this.summarizer) {
                this.summarizer.stop();
            }
        });

        // Development tools
        if (process.env.NODE_ENV === 'development') {
            this.mainWindow.webContents.openDevTools();
        }
    }

    createMenu() {
        const template = [
            {
                label: 'File',
                submenu: [
                    {
                        label: 'Open Transcript...',
                        accelerator: 'CmdOrCtrl+O',
                        click: () => {
                            this.handleOpenTranscript();
                        }
                    },
                    {
                        label: 'Select Screenshots Directory...',
                        click: () => {
                            this.handleSelectScreenshotsDir();
                        }
                    },
                    { type: 'separator' },
                    {
                        label: 'Quit',
                        accelerator: process.platform === 'darwin' ? 'Cmd+Q' : 'Ctrl+Q',
                        click: () => {
                            app.quit();
                        }
                    }
                ]
            }
        ];

        // On macOS, add the app menu
        if (process.platform === 'darwin') {
            template.unshift({
                label: app.getName(),
                submenu: [
                    { role: 'about' },
                    { type: 'separator' },
                    { role: 'services' },
                    { type: 'separator' },
                    { role: 'hide' },
                    { role: 'hideothers' },
                    { role: 'unhide' },
                    { type: 'separator' },
                    { role: 'quit' }
                ]
            });

            // Add Window menu
            template.push({
                label: 'Window',
                submenu: [
                    { role: 'minimize' },
                    { role: 'close' }
                ]
            });
        }

        const menu = Menu.buildFromTemplate(template);
        Menu.setApplicationMenu(menu);
    }

    async handleOpenTranscript() {
        console.log('handleOpenTranscript called');
        
        // Stop existing summarizer if running
        if (this.summarizer) {
            console.log('Stopping existing summarizer...');
            await this.summarizer.stop();
            this.summarizer = null;
            this.sendToRenderer('status-update', { connected: false });
        }

        // Show file selection dialog
        const result = await dialog.showOpenDialog(this.mainWindow, {
            title: 'Select Transcript File',
            properties: ['openFile'],
            filters: [
                { name: 'Text Files', extensions: ['txt', 'log', 'md'] },
                { name: 'Subtitle Files', extensions: ['srt', 'vtt'] },
                { name: 'All Files', extensions: ['*'] }
            ]
        });

        if (!result.canceled && result.filePaths.length > 0) {
            // Update app settings with new transcript file
            this.appSettings.transcriptFile = result.filePaths[0];
            
            // Save settings
            this.saveSettings();
            
            // Reinitialize summarizer with new file
            this.initializeSummarizer();
        }
    }

    async handleSelectScreenshotsDir() {
        console.log('handleSelectScreenshotsDir called');
        
        // Show directory selection dialog
        const result = await dialog.showOpenDialog(this.mainWindow, {
            title: 'Select Screenshots Directory',
            properties: ['openDirectory']
        });

        if (!result.canceled && result.filePaths.length > 0) {
            // Update app settings with new screenshots directory
            this.appSettings.screenshotsDir = result.filePaths[0];
            
            // Save settings
            this.saveSettings();
            
            // Update summarizer's screenshots directory if it exists
            if (this.summarizer) {
                this.summarizer.screenshotsDir = this.appSettings.screenshotsDir;
                // Re-setup screenshot watcher with new directory
                if (this.summarizer.setupScreenshotWatcher) {
                    this.summarizer.setupScreenshotWatcher();
                }
                // Send updated screenshots to renderer
                this.sendScreenshotsUpdate();
            }
            
            // Send updated app data to renderer
            this.sendAppDataUpdate();
        }
    }

    async showFileSelectionDialog() {
        const result = await dialog.showOpenDialog(this.mainWindow, {
            title: 'Select Transcript File',
            properties: ['openFile'],
            filters: [
                { name: 'Text Files', extensions: ['txt', 'log', 'md'] },
                { name: 'Subtitle Files', extensions: ['srt', 'vtt'] },
                { name: 'All Files', extensions: ['*'] }
            ]
        });

        if (!result.canceled && result.filePaths.length > 0) {
            this.appSettings.transcriptFile = result.filePaths[0];
            
            // Ask for screenshots directory
            const screenshotResult = await dialog.showOpenDialog(this.mainWindow, {
                title: 'Select Screenshots Directory (Optional)',
                properties: ['openDirectory']
            });

            if (!screenshotResult.canceled && screenshotResult.filePaths.length > 0) {
                this.appSettings.screenshotsDir = screenshotResult.filePaths[0];
            }

            this.saveSettings();
            this.initializeSummarizer();
        } else {
            // User canceled, close app
            app.quit();
        }
    }

    initializeSummarizer() {
        console.log('initializeSummarizer called');
        console.log('Transcript file:', this.appSettings.transcriptFile);
        
        if (!this.appSettings.transcriptFile || !fs.existsSync(this.appSettings.transcriptFile)) {
            console.error('Transcript file not found:', this.appSettings.transcriptFile);
            dialog.showErrorBox('Error', 'Transcript file not found or not selected.');
            return;
        }

        try {
            console.log('Creating ElectronTranscriptSummarizer...');
            // Create modified TranscriptSummarizer for Electron
            this.summarizer = new ElectronTranscriptSummarizer(
                this.appSettings.transcriptFile,
                this.appSettings.screenshotsDir,
                this
            );

            console.log('Starting summarizer...');
            this.summarizer.start();
            
            // Send initial data to renderer
            console.log('Sending initial data to renderer...');
            this.sendToRenderer('status-update', { connected: true });
            this.sendScreenshotsUpdate();
            this.sendAppDataUpdate();
            
            // Send existing transcript content
            this.sendExistingTranscriptContent();
            
        } catch (error) {
            console.error('Error initializing summarizer:', error);
            dialog.showErrorBox('Error', `Failed to initialize transcript monitoring: ${error.message}`);
        }
    }

    setupIPC() {
        // File operations
        ipcMain.handle('select-transcript-file', async () => {
            const result = await dialog.showOpenDialog(this.mainWindow, {
                title: 'Select Transcript File',
                properties: ['openFile'],
                filters: [
                    { name: 'Text Files', extensions: ['txt', 'log', 'md'] },
                    { name: 'Subtitle Files', extensions: ['srt', 'vtt'] },
                    { name: 'All Files', extensions: ['*'] }
                ]
            });
            
            if (!result.canceled && result.filePaths.length > 0) {
                this.appSettings.transcriptFile = result.filePaths[0];
                this.saveSettings();
                return result.filePaths[0];
            }
            return null;
        });

        ipcMain.handle('select-screenshots-dir', async () => {
            const result = await dialog.showOpenDialog(this.mainWindow, {
                title: 'Select Screenshots Directory',
                properties: ['openDirectory']
            });
            
            if (!result.canceled && result.filePaths.length > 0) {
                this.appSettings.screenshotsDir = result.filePaths[0];
                this.saveSettings();
                return result.filePaths[0];
            }
            return null;
        });

        // Summarizer operations
        ipcMain.handle('create-summary', async (_, sessionContext) => {
            if (this.summarizer) {
                return await this.summarizer.createSummaryFromCurrent();
            }
        });

        ipcMain.handle('generate-note', async (_, noteData) => {
            if (this.summarizer) {
                const { header, mode, selectedScreenshots, sessionContext, startWordIndex, endWordIndex } = noteData;
                
                // Update summarizer's selected screenshots
                this.summarizer.selectedScreenshots = selectedScreenshots;
                
                // Update session context if provided
                if (sessionContext) {
                    this.summarizer.sessionContext = sessionContext;
                }

                switch (mode) {
                    case 'text-only':
                        return await this.summarizer.createNote(header, true, startWordIndex, endWordIndex);
                    case 'screenshots-only':
                        return await this.summarizer.createNoteFromScreenshotsOnly(header, startWordIndex, endWordIndex);
                    default:
                        return await this.summarizer.createNote(header, false, startWordIndex, endWordIndex);
                }
            }
        });

        ipcMain.handle('update-screenshot-selection', (_, selectedPaths) => {
            if (this.summarizer) {
                this.summarizer.selectedScreenshots = selectedPaths;
            }
        });

        ipcMain.handle('set-screenshot-filter', (_, filter) => {
            // Update current filter state and screenshot list
            this.currentScreenshotFilter = filter;
            this.sendScreenshotsUpdate(filter);
        });

        ipcMain.handle('update-settings', (_, settings) => {
            if (this.summarizer) {
                this.summarizer.contextWordLimit = settings.wordLimit || 0;
                this.summarizer.readOnlyMode = settings.readOnlyMode;
                // Apply other settings...
            }
        });

        ipcMain.handle('save-notes', async (_, content) => {
            if (this.summarizer) {
                const notesPath = this.summarizer.notesFilePath;
                try {
                    // Convert HTML to markdown or plain text
                    const textContent = this.htmlToMarkdown(content);
                    fs.writeFileSync(notesPath, textContent, 'utf8');
                    return true;
                } catch (error) {
                    console.error('Error saving notes:', error);
                    return false;
                }
            }
        });

        ipcMain.handle('export-notes', async () => {
            if (this.summarizer) {
                const result = await dialog.showSaveDialog(this.mainWindow, {
                    title: 'Export Notes',
                    defaultPath: 'meeting-notes.md',
                    filters: [
                        { name: 'Markdown', extensions: ['md'] },
                        { name: 'Text', extensions: ['txt'] },
                        { name: 'HTML', extensions: ['html'] }
                    ]
                });

                if (!result.canceled) {
                    try {
                        const notes = fs.readFileSync(this.summarizer.notesFilePath, 'utf8');
                        fs.writeFileSync(result.filePath, notes, 'utf8');
                        return true;
                    } catch (error) {
                        dialog.showErrorBox('Export Error', error.message);
                        return false;
                    }
                }
            }
            return false;
        });

        ipcMain.handle('seek-timeline', (_, position) => {
            // Handle timeline seeking - could adjust the file reading position
            console.log('Seeking to position:', position);
        });

        ipcMain.handle('select-timeline-range', (_, startPercent, endPercent) => {
            // Handle timeline range selection
            console.log('Selected range:', startPercent, 'to', endPercent);
        });

        ipcMain.handle('update-session-context', (_, context) => {
            if (this.summarizer) {
                this.summarizer.sessionContext = context;
            }
        });

        ipcMain.handle('load-notes', async () => {
            if (this.summarizer) {
                try {
                    if (fs.existsSync(this.summarizer.notesFilePath)) {
                        const notesContent = fs.readFileSync(this.summarizer.notesFilePath, 'utf8');
                        return this.markdownToHtml(notesContent);
                    }
                    return '';
                } catch (error) {
                    console.error('Error loading notes:', error);
                    return '';
                }
            }
            return '';
        });

        // Menu and external links
        ipcMain.handle('open-external', (_, url) => {
            shell.openExternal(url);
        });

        ipcMain.handle('open-file', async () => {
            await this.handleOpenFile();
        });

        // Renderer ready signal
        ipcMain.handle('renderer-ready', () => {
            console.log('Renderer process ready');
            
            // Show window if not visible
            if (this.mainWindow && !this.mainWindow.isVisible()) {
                console.log('Showing window now that renderer is ready');
                this.mainWindow.show();
                this.mainWindow.focus();
            }
            
            // Always re-initialize data when renderer is ready (handles refresh case)
            if (this.appSettings.transcriptFile) {
                if (!this.summarizer) {
                    console.log('Initializing summarizer for the first time');
                    this.initializeSummarizer();
                } else {
                    console.log('Re-sending data to refreshed renderer');
                    // Re-send all data to the refreshed renderer
                    this.sendToRenderer('status-update', { connected: true });
                    this.sendScreenshotsUpdate();
                    this.sendAppDataUpdate();
                    this.sendExistingTranscriptContent();
                }
            }
        });

        // Audio recording IPC handlers
        ipcMain.handle('get-audio-status', async () => {
            let availableInputs = [];
            
            // Get available audio inputs on macOS
            if (process.platform === 'darwin') {
                try {
                    availableInputs = await this.macOSAudioManager.getAvailableAudioInputs();
                } catch (error) {
                    console.error('Error getting audio inputs:', error);
                    availableInputs = [
                        { name: 'Default System Input', id: 'default', inputs: ['Default'], hasInputs: true }
                    ];
                }
            }
            
            return {
                platform: process.platform,
                blackHoleStatus: this.blackHoleStatus,
                setupGuide: this.blackHoleStatus ? this.audioSetupGuide.showMacOSSetup(this.blackHoleStatus) : null,
                settings: this.appSettings.audio,
                availableInputs
            };
        });

        ipcMain.handle('refresh-audio-detection', async () => {
            if (process.platform === 'darwin') {
                this.blackHoleStatus = await this.macOSAudioManager.detectBlackHole();
                return {
                    blackHoleStatus: this.blackHoleStatus,
                    setupGuide: this.audioSetupGuide.showMacOSSetup(this.blackHoleStatus)
                };
            }
            return { error: 'Not supported on this platform' };
        });

        ipcMain.handle('update-audio-settings', (_, audioSettings) => {
            this.appSettings.audio = { ...this.appSettings.audio, ...audioSettings };
            this.saveSettings();
            return this.appSettings.audio;
        });

        ipcMain.handle('start-audio-recording', async (_, sessionContext) => {
            try {
                const session = this.audioFileManager.startSession(sessionContext, app.getPath('userData'));
                console.log('Started audio recording session:', session.id);
                return { success: true, sessionId: session.id };
            } catch (error) {
                console.error('Error starting audio recording:', error);
                return { success: false, error: error.message };
            }
        });

        ipcMain.handle('stop-audio-recording', async () => {
            try {
                const sessionData = this.audioFileManager.stopSession();
                console.log('Stopped audio recording session');
                return { success: true, sessionData };
            } catch (error) {
                console.error('Error stopping audio recording:', error);
                return { success: false, error: error.message };
            }
        });

        ipcMain.handle('process-audio-chunk', async (_, chunkBuffer) => {
            try {
                await this.audioFileManager.processAudioChunk(chunkBuffer);
                
                // If auto-transcribe is enabled, process for transcription
                if (this.appSettings.audio.autoTranscribe) {
                    await this.processAudioForTranscription(chunkBuffer);
                }
                
                return { success: true };
            } catch (error) {
                console.error('Error processing audio chunk:', error);
                return { success: false, error: error.message };
            }
        });

        ipcMain.handle('open-blackhole-installer', () => {
            shell.openExternal('https://github.com/ExistentialAudio/BlackHole');
        });

        ipcMain.handle('open-audio-midi-setup', () => {
            shell.openExternal('file:///Applications/Utilities/Audio%20MIDI%20Setup.app');
        });
    }

    async processAudioForTranscription(chunkBuffer) {
        try {
            // Save the audio chunk temporarily for transcription
            const tempDir = path.join(app.getPath('userData'), 'temp');
            fs.mkdirSync(tempDir, { recursive: true });
            
            const timestamp = Date.now();
            const tempAudioFile = path.join(tempDir, `audio_chunk_${timestamp}.webm`);
            
            // Write chunk to temporary file
            fs.writeFileSync(tempAudioFile, Buffer.from(chunkBuffer));
            
            // Use existing transcript summarizer to transcribe
            if (this.transcriptSummarizer) {
                try {
                    // Create a simulated transcript line for now
                    // In a real implementation, you would:
                    // 1. Convert audio to text using speech recognition service
                    // 2. Parse the text into transcript format
                    
                    const transcriptLine = {
                        timestamp: new Date().toLocaleTimeString(),
                        speaker: 'Live Audio',
                        content: 'Audio transcription in progress...' // Placeholder
                    };
                    
                    // Add to transcript through the normal flow
                    const transcriptData = {
                        lines: [transcriptLine],
                        wordCount: this.wordCount + transcriptLine.content.split(/\s+/).length,
                        currentPosition: this.currentPosition + transcriptLine.content.split(/\s+/).length
                    };
                    
                    this.wordCount = transcriptData.wordCount;
                    this.currentPosition = transcriptData.currentPosition;
                    
                    // Send to renderer
                    this.sendToRenderer('transcript-update', transcriptData);
                    
                    console.log('Processed audio chunk for transcription');
                    
                } catch (transcriptionError) {
                    console.error('Error in transcription process:', transcriptionError);
                }
            }
            
            // Clean up temporary file
            setTimeout(() => {
                try {
                    if (fs.existsSync(tempAudioFile)) {
                        fs.unlinkSync(tempAudioFile);
                    }
                } catch (cleanupError) {
                    console.error('Error cleaning up temp file:', cleanupError);
                }
            }, 5000); // Keep file for 5 seconds in case needed for debugging
            
        } catch (error) {
            console.error('Error processing audio for transcription:', error);
        }
    }

    sendToRenderer(channel, data) {
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send(channel, data);
        }
    }

    sendTranscriptUpdate(lines, wordCount, currentPosition) {
        this.sendToRenderer('transcript-update', {
            lines,
            wordCount,
            currentPosition
        });
    }

    sendScreenshotsUpdate(filter = null) {
        if (!this.summarizer) return;

        // Use provided filter or fall back to current filter state
        const activeFilter = filter || this.currentScreenshotFilter;

        const screenshots = activeFilter === 'session' 
            ? this.summarizer.getScreenshotFiles(true)
            : this.summarizer.getScreenshotFiles(false);

        const screenshotData = screenshots.map(path => ({
            path,
            filename: path.split('/').pop(),
            selected: this.summarizer.selectedScreenshots.includes(path)
        }));

        this.sendToRenderer('screenshots-update', screenshotData);
    }

    sendNoteCreated(noteData) {
        this.sendToRenderer('note-created', noteData);
    }

    sendSummaryUpdate(summary) {
        this.sendToRenderer('summary-update', summary);
    }

    sendCostUpdate(costData) {
        this.sendToRenderer('cost-update', costData);
    }

    sendAppDataUpdate() {
        const transcriptFilename = this.appSettings.transcriptFile 
            ? path.basename(this.appSettings.transcriptFile, path.extname(this.appSettings.transcriptFile))
            : '';
        
        this.sendToRenderer('app-data-update', {
            transcriptFilename,
            transcriptPath: this.appSettings.transcriptFile,
            screenshotsDir: this.appSettings.screenshotsDir
        });
    }

    sendExistingTranscriptContent() {
        if (!this.summarizer) return;
        
        try {
            console.log('Loading existing transcript content...');
            const lines = this.summarizer.parseTranscriptToLines();
            const wordCount = this.summarizer.getWordCount();
            const currentPosition = this.summarizer.lastPosition;
            
            console.log(`Sending ${lines.length} transcript lines to renderer`);
            
            this.sendTranscriptUpdate(lines, wordCount, currentPosition);
        } catch (error) {
            console.error('Error sending existing transcript content:', error);
        }
    }

    markdownToHtml(markdown) {
        // Enhanced Markdown to HTML conversion for WYSIWYG editing
        let html = markdown;
        
        // Store and temporarily replace HTML comments to protect them from escaping
        const comments = [];
        html = html.replace(/<!--.*?-->/g, (match) => {
            const placeholder = `__COMMENT_${comments.length}__`;
            comments.push(match);
            return placeholder;
        });
        
        // Escape HTML entities for content safety
        html = html
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        
        // Process headings (with comment placeholders)
        html = html
            .replace(/^#### (.+)$/gm, '<h4>$1</h4>')
            .replace(/^### (.+)$/gm, '<h3>$1</h3>')
            .replace(/^## (.+?)(\s*__COMMENT_\d+__)?$/gm, (match, headerText, commentPlaceholder) => {
                return `<h2>${headerText}</h2>${commentPlaceholder || ''}`;
            })
            .replace(/^# (.+)$/gm, '<h1>$1</h1>');
        
        // Restore HTML comments
        comments.forEach((comment, index) => {
            html = html.replace(`__COMMENT_${index}__`, comment);
        });
        
        
        // Process inline formatting (bold and italic)
        html = html
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.+?)\*/g, '<em>$1</em>');
        
        // Split into blocks for better list processing
        const blocks = html.split(/\n\s*\n/);
        const processedBlocks = blocks.map(block => {
            const lines = block.split('\n');
            
            // Check if this block contains bullet list items
            if (lines.some(line => line.match(/^- .+/))) {
                const listItems = lines
                    .filter(line => line.match(/^- .+/))
                    .map(line => line.replace(/^- (.+)/, '<li>$1</li>'))
                    .join('');
                const nonListLines = lines
                    .filter(line => !line.match(/^- .+/) && line.trim())
                    .join('<br>');
                
                return (nonListLines ? `<p>${nonListLines}</p>` : '') + 
                       (listItems ? `<ul>${listItems}</ul>` : '');
            }
            
            // Check if this block contains numbered list items
            else if (lines.some(line => line.match(/^\d+\. .+/))) {
                const listItems = lines
                    .filter(line => line.match(/^\d+\. .+/))
                    .map(line => line.replace(/^\d+\. (.+)/, '<li>$1</li>'))
                    .join('');
                const nonListLines = lines
                    .filter(line => !line.match(/^\d+\. .+/) && line.trim())
                    .join('<br>');
                
                return (nonListLines ? `<p>${nonListLines}</p>` : '') + 
                       (listItems ? `<ol>${listItems}</ol>` : '');
            }
            
            // Regular paragraph or heading
            else {
                const content = lines.join('<br>').trim();
                if (content.match(/^<h[1-6]>/)) {
                    return content; // Already a heading
                } else if (content) {
                    // Check if content starts with an HTML comment - handle specially
                    if (content.match(/^<!--.*?-->/)) {
                        // Split comment from the rest of the content
                        const match = content.match(/^(<!--.*?-->)\s*(.*)/s);
                        if (match) {
                            const comment = match[1];
                            const restContent = match[2].trim();
                            return comment + (restContent ? `<p>${restContent}</p>` : '');
                        }
                        return content; // Fallback
                    }
                    return `<p>${content}</p>`;
                }
                return '';
            }
        });
        
        return processedBlocks.filter(block => block).join('');
    }

    htmlToMarkdown(html) {
        // Enhanced HTML to Markdown conversion with proper list handling
        let markdown = html;
        
        // Convert headings (preserve word index comments for H2)
        markdown = markdown
            .replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n\n')
            .replace(/<h2[^>]*>(.*?)<\/h2>(<!--.*?-->)?/gi, '## $1$2\n\n')
            .replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n\n')
            .replace(/<h4[^>]*>(.*?)<\/h4>/gi, '#### $1\n\n');
        
        // Convert inline formatting
        markdown = markdown
            .replace(/<strong[^>]*>(.*?)<\/strong>/gi, '**$1**')
            .replace(/<em[^>]*>(.*?)<\/em>/gi, '*$1*');
        
        // Convert unordered lists
        markdown = markdown
            .replace(/<ul[^>]*>(.*?)<\/ul>/gis, (match, content) => {
                const items = content.match(/<li[^>]*>(.*?)<\/li>/gi) || [];
                return items.map(item => 
                    item.replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1')
                ).join('\n') + '\n\n';
            });
        
        // Convert ordered lists
        markdown = markdown
            .replace(/<ol[^>]*>(.*?)<\/ol>/gis, (match, content) => {
                const items = content.match(/<li[^>]*>(.*?)<\/li>/gi) || [];
                return items.map((item, index) => 
                    item.replace(/<li[^>]*>(.*?)<\/li>/gi, `${index + 1}. $1`)
                ).join('\n') + '\n\n';
            });
        
        // Convert paragraphs and other elements
        markdown = markdown
            .replace(/<p[^>]*>(.*?)<\/p>/gi, '$1\n\n')
            .replace(/<div[^>]*>(.*?)<\/div>/gi, '$1\n')
            .replace(/<br[^>]*>/gi, '\n');
        
        // Preserve HTML comments with word indices before removing other tags
        const wordIndexComments = [];
        markdown = markdown.replace(/<!--\s*words:(\d+)-(\d+)\s*-->/g, (match, start, end) => {
            const placeholder = `__WORD_INDEX_${wordIndexComments.length}__`;
            wordIndexComments.push(match);
            return placeholder;
        });
        
        // Remove any remaining HTML tags
        markdown = markdown.replace(/<[^>]*>/g, '');
        
        // Restore word index comments
        wordIndexComments.forEach((comment, index) => {
            markdown = markdown.replace(`__WORD_INDEX_${index}__`, comment);
        });
        
        // Decode HTML entities
        markdown = markdown
            .replace(/&nbsp;/g, ' ')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&');
        
        // Clean up extra whitespace
        markdown = markdown
            .replace(/\n\s*\n\s*\n/g, '\n\n') // Normalize multiple line breaks
            .replace(/^\s+|\s+$/g, '') // Trim start and end
            .trim();
        
        return markdown;
    }

    loadWindowState() {
        try {
            const settingsPath = path.join(__dirname, '..', 'app-settings.json');
            if (fs.existsSync(settingsPath)) {
                const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
                this.appSettings = { ...this.appSettings, ...settings };
            }
        } catch (error) {
            console.log('Could not load settings:', error.message);
        }
    }

    saveWindowState() {
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            const bounds = this.mainWindow.getBounds();
            this.appSettings.windowState = {
                width: bounds.width,
                height: bounds.height,
                x: bounds.x,
                y: bounds.y
            };
            this.saveSettings();
        }
    }

    saveSettings() {
        try {
            const settingsPath = path.join(__dirname, '..', 'app-settings.json');
            fs.writeFileSync(settingsPath, JSON.stringify(this.appSettings, null, 2), 'utf8');
        } catch (error) {
            console.log('Could not save settings:', error.message);
        }
    }
}

// Extended TranscriptSummarizer for Electron integration
class ElectronTranscriptSummarizer extends TranscriptSummarizer {
    constructor(filePath, screenshotsDir, electronApp) {
        super(filePath, screenshotsDir);
        this.electronApp = electronApp;
        this.sessionContext = '';
        this.screenshotWatcher = null;
        this.setupScreenshotWatcher();
    }

    setupScreenshotWatcher() {
        if (!this.screenshotsDir || !fs.existsSync(this.screenshotsDir)) {
            console.log('Screenshots directory not available for watching');
            return;
        }

        try {
            console.log(`Starting to watch screenshots directory: ${this.screenshotsDir}`);
            
            // Watch the screenshots directory for changes
            this.screenshotWatcher = fs.watch(this.screenshotsDir, { persistent: true }, (eventType, filename) => {
                if (!filename) return;
                
                // Check if it's an image file
                const imageExtensions = /\.(png|jpg|jpeg|gif|bmp|webp)$/i;
                if (!imageExtensions.test(filename)) return;
                
                console.log(`Screenshot ${eventType}: ${filename}`);
                
                // Debounce rapid file system events
                clearTimeout(this.screenshotUpdateTimeout);
                this.screenshotUpdateTimeout = setTimeout(() => {
                    this.electronApp.sendScreenshotsUpdate();
                }, 500);
            });
            
        } catch (error) {
            console.error('Error setting up screenshot watcher:', error);
        }
    }

    // Override stop method to clean up watcher
    async stop() {
        if (this.screenshotWatcher) {
            this.screenshotWatcher.close();
            this.screenshotWatcher = null;
        }
        
        await super.stop();
    }

    // Override console.log methods to send to renderer instead
    log(...args) {
        console.log(...args); // Keep for debugging
        // Could send log messages to renderer UI
    }

    // Override the processNewContent method to send updates to UI
    async processNewContent() {
        try {
            const stats = fs.statSync(this.filePath);
            if (stats.size > this.lastPosition) {
                const stream = fs.createReadStream(this.filePath, {
                    start: this.lastPosition,
                    end: stats.size
                });

                let newContent = '';
                stream.on('data', (chunk) => {
                    newContent += chunk.toString();
                });

                stream.on('end', async () => {
                    const trimmedContent = newContent.trim();
                    
                    if (trimmedContent) {
                        console.log(`\n📝 New transcript content (${newContent.length} chars):`);
                        console.log(trimmedContent);
                        
                        this.pendingContent += ' ' + trimmedContent;
                        this.lastPosition = stats.size;
                        
                        // Send only the new lines to renderer for animation
                        const newLines = this.parseNewContent(trimmedContent);
                        if (newLines.length > 0 && this.electronApp) {
                            this.electronApp.sendTranscriptUpdate(
                                newLines,
                                this.getWordCount(),
                                this.lastPosition
                            );
                        }
                    }
                });
            }
        } catch (error) {
            console.error('Error processing new content:', error.message);
        }
    }

    // Parse only new content into lines
    parseNewContent(content) {
        try {
            const lines = content.split('\n').filter(line => line.trim());
            const parsedLines = [];
            
            // Calculate the current word index by getting existing word count
            let currentWordIndex = this.getWordCount() - content.trim().split(/\s+/).length;
            
            lines.forEach((line) => {
                const parsed = this.parseTranscriptLineFlexible(line.trim());
                if (parsed) {
                    const lineWordCount = parsed.content.split(/\s+/).length;
                    parsedLines.push({
                        timestamp: parsed.timestamp,
                        speaker: parsed.speaker,
                        content: parsed.content,
                        wordIndex: currentWordIndex,
                        wordCount: lineWordCount
                    });
                    currentWordIndex += lineWordCount;
                }
            });
            
            return parsedLines;
        } catch (error) {
            console.error('Error parsing new content:', error);
            return [];
        }
    }

    parseTranscriptToLines() {
        try {
            const content = fs.readFileSync(this.filePath, 'utf8');
            console.log('Transcript content length:', content.length);
            
            // Split content into lines
            const initialLines = content.split('\n').filter(line => line.trim());
            console.log('Total initial lines:', initialLines.length);
            
            // Check if this is already line-separated (time range format like SRT)
            const hasTimeRangeFormat = initialLines.some(line => 
                line.match(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}\]/)
            );
            
            let lines = [];
            
            if (hasTimeRangeFormat) {
                // Time range format is already separated by lines
                lines = initialLines;
                console.log('Detected time range format, using existing line breaks');
            } else {
                // Check if this is Microsoft Teams format with speaker changes
                const firstLineHasTimestamp = initialLines[0] && initialLines[0].match(/^\[\d{2}:\d{2}:\d{2}\.\d+\]/);
                
                if (firstLineHasTimestamp) {
                    console.log('Detected Microsoft Teams format');
                    
                    // For Microsoft Teams format, treat each line as a separate transcript entry
                    // but preserve the original text format without adding synthetic speakers/timestamps
                    for (let i = 0; i < initialLines.length; i++) {
                        const line = initialLines[i];
                        
                        if (line.trim()) {
                            lines.push(line);
                        }
                    }
                } else {
                    // Try to split by timestamp markers [XX:XX:XX.XX] for other formats
                    const timestampPattern = /(\[\d{2}:\d{2}:\d{2}\.\d{1,3}\]:?)/g;
                    const segments = content.split(timestampPattern).filter(segment => segment.trim());
                    
                    console.log('Total segments after splitting by timestamps:', segments.length);
                    
                    // Reconstruct lines by combining timestamp + content pairs
                    for (let i = 0; i < segments.length - 1; i += 2) {
                        if (segments[i].match(timestampPattern) && segments[i + 1]) {
                            lines.push(segments[i] + segments[i + 1]);
                        }
                    }
                }
            }
            
            console.log('Reconstructed lines:', lines.length);
            
            if (lines.length > 0) {
                console.log('First line example:', lines[0].substring(0, 100) + '...');
                console.log('Second line example:', lines[1] ? lines[1].substring(0, 100) + '...' : 'No second line');
                console.log('Third line example:', lines[2] ? lines[2].substring(0, 100) + '...' : 'No third line');
            }
            
            // Parse each line using a more flexible parser
            const parsedLines = lines.map((line, index) => {
                const parsed = this.parseTranscriptLineFlexible(line.trim());
                console.log(`Line ${index + 1}: "${line.trim().substring(0, 50)}..." -> Parsed:`, parsed ? 'SUCCESS' : 'FAILED');
                if (parsed) {
                    return {
                        timestamp: parsed.timestamp,
                        speaker: parsed.speaker,
                        content: parsed.content
                    };
                }
                return null;
            }).filter(Boolean);
            
            console.log('Successfully parsed lines:', parsedLines.length);
            return parsedLines;
        } catch (error) {
            console.error('Error parsing transcript lines:', error);
            return [];
        }
    }

    parseTranscriptLineFlexible(line) {
        // Try multiple patterns to extract timestamp, speaker, and content
        
        // Pattern 1: [HH:MM:SS.SS] Speaker: Content
        let match = line.match(/^\[(\d{2}:\d{2}:\d{2}\.\d{1,3})\]\s*([^:]+):\s*(.+)$/);
        if (match) {
            return {
                timestamp: match[1],
                speaker: match[2].trim(),
                content: match[3].trim()
            };
        }
        
        // Pattern 2: [HH:MM:SS.SS] Content (no explicit speaker)
        match = line.match(/^\[(\d{2}:\d{2}:\d{2}\.\d{1,3})\]\s*(.+)$/);
        if (match) {
            return {
                timestamp: match[1],
                speaker: '', // Empty speaker for display
                content: match[2].trim()
            };
        }
        
        // Pattern 3: Just content without timestamp (don't add synthetic data)
        if (line.trim()) {
            return {
                timestamp: '', // Empty timestamp for display
                speaker: '', // Empty speaker for display
                content: line.trim()
            };
        }
        
        return null;
    }

    getWordCount() {
        try {
            const content = fs.readFileSync(this.filePath, 'utf8');
            return content.trim().split(/\s+/).length;
        } catch (error) {
            return 0;
        }
    }

    // Override note creation to send updates to UI
    async createNote(noteRequest, forceTextOnly = false, startWordIndex = null, endWordIndex = null) {
        // Calculate the actual word indices that will be used (same logic as parent method)
        let actualStartWordIndex = startWordIndex;
        let actualEndWordIndex = endWordIndex;
        
        if (startWordIndex === null || endWordIndex === null) {
            if (this.contextWordLimit > 0) {
                const fullTranscript = this.getActiveTranscript();
                const words = fullTranscript.trim().split(/\s+/);
                const totalWords = words.length;
                
                if (totalWords > this.contextWordLimit) {
                    actualStartWordIndex = totalWords - this.contextWordLimit;
                    actualEndWordIndex = totalWords - 1;
                } else {
                    actualStartWordIndex = 0;
                    actualEndWordIndex = totalWords - 1;
                }
            }
        }
        
        const result = await super.createNote(noteRequest, forceTextOnly, startWordIndex, endWordIndex);
        
        if (this.electronApp) {
            // Create the properly formatted note content with H2 header and word indices
            let formattedContent = '';
            if (noteRequest) {
                formattedContent += `## ${noteRequest}`;
                if (actualStartWordIndex !== null && actualEndWordIndex !== null) {
                    formattedContent += ` <!-- words:${actualStartWordIndex}-${actualEndWordIndex} -->`;
                }
                formattedContent += `\n\n${result || ''}`;
            } else {
                formattedContent = result || noteRequest;
            }
            
            // Convert markdown to HTML for proper display in WYSIWYG editor
            const htmlContent = this.electronApp.markdownToHtml(formattedContent);
            
            // Send note created event with HTML content
            this.electronApp.sendNoteCreated({
                content: htmlContent,
                position: this.lastPosition,
                id: Date.now().toString()
            });
        }
        
        return result;
    }

    // Override screenshot-only note creation to send updates to UI
    async createNoteFromScreenshotsOnly(noteRequest, startWordIndex = null, endWordIndex = null) {
        // Calculate the actual word indices that will be used (same logic as parent method)
        let actualStartWordIndex = startWordIndex;
        let actualEndWordIndex = endWordIndex;
        
        if (startWordIndex === null || endWordIndex === null) {
            if (this.contextWordLimit > 0) {
                const fullTranscript = this.getActiveTranscript();
                const words = fullTranscript.trim().split(/\s+/);
                const totalWords = words.length;
                
                if (totalWords > this.contextWordLimit) {
                    actualStartWordIndex = totalWords - this.contextWordLimit;
                    actualEndWordIndex = totalWords - 1;
                } else {
                    actualStartWordIndex = 0;
                    actualEndWordIndex = totalWords - 1;
                }
            }
        }
        
        const result = await super.createNoteFromScreenshotsOnly(noteRequest, startWordIndex, endWordIndex);
        
        if (this.electronApp) {
            // Create the properly formatted note content with H2 header and word indices
            let formattedContent = '';
            if (noteRequest) {
                formattedContent += `## ${noteRequest}`;
                if (actualStartWordIndex !== null && actualEndWordIndex !== null) {
                    formattedContent += ` <!-- words:${actualStartWordIndex}-${actualEndWordIndex} -->`;
                }
                formattedContent += `\n\n${result || ''}`;
            } else {
                formattedContent = result || noteRequest;
            }
            
            // Convert markdown to HTML for proper display in WYSIWYG editor
            const htmlContent = this.electronApp.markdownToHtml(formattedContent);
            
            // Send note created event with HTML content
            this.electronApp.sendNoteCreated({
                content: htmlContent,
                position: this.lastPosition,
                id: Date.now().toString()
            });
        }
        
        return result;
    }

    // Override cost reporting to send to UI
    displayCostReport(requestCost, inputTokens, outputTokens) {
        super.displayCostReport(requestCost, inputTokens, outputTokens);
        
        if (this.electronApp) {
            this.electronApp.sendCostUpdate({
                request: requestCost,
                total: this.totalCost,
                tokens: {
                    input: inputTokens,
                    output: outputTokens,
                    totalInput: this.totalInputTokens,
                    totalOutput: this.totalOutputTokens
                }
            });
        }
    }

    // Override summary updates
    async updateSummary(newContent) {
        const result = await super.updateSummary(newContent);
        
        if (this.electronApp) {
            this.electronApp.sendSummaryUpdate(this.currentSummary);
        }
        
        return result;
    }
}

// Create and start the app
new ElectronTranscriptApp();

// Export for require
module.exports = { ElectronTranscriptApp, ElectronTranscriptSummarizer };